const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    if (!user || !senha) {
        return res.status(400).json({ error: 'RA e senha são obrigatórios.' });
    }

    try {
        // User-Agent idêntico a um navegador moderno para evitar o bloqueio automatizado da IP.TV
        const browserHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        };

        // ==========================================
        // CHAMADA [#2]: AUTENTICAÇÃO PRIMÁRIA (SED)
        // ==========================================
        const loginResponse = await axios.post(
            'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken',
            { user, senha },
            {
                headers: {
                    ...browserHeaders,
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
                    'X-Product-Name': 'SalaDoFuturo',
                    'Content-Type': 'application/json'
                }
            }
        );

        const tokenLongoSED = loginResponse.data.token;
        const dadosUsuario = loginResponse.data.DadosUsuario;

        if (!tokenLongoSED || !dadosUsuario || !dadosUsuario.CD_USUARIO) {
            return res.status(401).json({ error: 'Falha na leitura dos dados de autenticação da SED.' });
        }

        const codigoAluno = dadosUsuario.CD_USUARIO;

        // ==========================================
        // CHAMADA [#3]: CONSULTA DE TURMA (ATIVAÇÃO 1)
        // ==========================================
        // Executada de forma síncrona para registrar o uso do token no gateway da SED
        const dadosEscolares = await axios.get(
            `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${codigoAluno}`, 
            {
                headers: { 
                    ...browserHeaders, 
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b' 
                }
            }
        );

        const infoEscola = dadosEscolares.data[0] || {};
        const escolaId = infoEscola.CodigoEscola || 0; 

        // ==========================================
        // CHAMADA [#4]: CONSULTA DE BIMESTRES (ATIVAÇÃO 2)
        // ==========================================
        // Força o gateway a reconhecer o contexto acadêmico do aluno antes de ir para o parceiro externo
        try {
            await axios.get(
                `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apihubintegracoes/api/Bimestre/ListarBimestres?escolaId=${escolaId}`,
                {
                    headers: { 
                        ...browserHeaders, 
                        'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b' 
                    }
                }
            );
        } catch (bimestreError) {
            console.warn('Aviso: Falha na ativação opcional de bimestres, prosseguindo...');
        }

        // Inicializa as variáveis de contagem
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;

        // ==========================================
        // CHAMADA [#5]: TROCA DE TOKEN (IP.TV)
        // ==========================================
        try {
            // Isolando completamente os headers. Removido o Ocp-Apim-Subscription-Key.
            // Injetado o Host e as diretivas de identidade exatas capturadas no log.
            const iptvTokenResponse = await axios.post(
                'https://edusp-api.ip.tv/registration/edusp/token',
                { token: tokenLongoSED }, // Payload JSON puro com o token longo idêntico caractere por caractere
                {
                    headers: {
                        'Host': 'edusp',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                        'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
                    }
                }
            );

            const auth_token_iptv = iptvTokenResponse.data.auth_token;

            if (auth_token_iptv) {
                // Consulta das tarefas pendentes usando a nova chave validada pela IP.TV
                const pendenciasResponse = await axios.get(
                    'https://edusp-api.ip.tv/tms/task/todo/count?filter_expired=true', 
                    {
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'application/json',
                            'x-api-key': auth_token_iptv 
                        }
                    }
                );
                tarefasPendentes = pendenciasResponse.data.todo || 0;
                tarefasExpiradas = pendenciasResponse.data.expired || 0;
            }
        } catch (iptvError) {
            console.error('Erro de Handshake na IP.TV:', iptvError.response?.data || iptvError.message);
        }

        // ==========================================
        // CHAMADA FINAL: CONSULTA DE AVALIAÇÕES (SED)
        // ==========================================
        const avaliacoesResponse = await axios.get(
            `https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${codigoAluno}&AnoLetivo=2026`, 
            {
                headers: { 
                    ...browserHeaders, 
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b' 
                }
            }
        );

        const totalAvaliacoes = Array.isArray(avaliacoesResponse.data) ? avaliacoesResponse.data.length : 0;

        // Retorno limpo e formatado para o index.html
        res.json({
            aluno: {
                codigo: codigoAluno,
                escola: infoEscola.NomeEscola || 'Não Informada',
                turma: infoEscola.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: 0
            }
        });

    } catch (error) {
        console.error('Erro crítico na orquestração:', error.message);
        res.status(500).json({ error: 'Erro ao processar dados no servidor administrativo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF orquestrado e corrigido rodando na porta ${PORT}`));
